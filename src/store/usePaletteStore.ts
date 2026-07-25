import { create } from "zustand";
import { persist } from "zustand/middleware";

import { parsePal } from "../lib/pal";

// User-supplied GRLevelX .pal colour tables. There's no palette picker on the
// radar panel any more: the palette follows the product, and a custom table
// *replaces* a built-in one (`overrides`). So importing a BR table means every
// reflectivity product uses it, everywhere, with no extra step.
//
// Since the browser does the colouring, a custom table costs no server work.

export interface CustomPalette {
  id: string; // "user:<slug>" -- namespaced so it can't collide with a built-in
  label: string;
  pal: string; // raw .pal text
  product: string | null; // the file's own `Product:` line, if any
  units: string | null;
  addedAt: number;
}

/** GRLevelX `Product:` code -> our built-in palette id. */
const PRODUCT_TO_PALETTE: Record<string, string> = {
  BR: "REF", BREF: "REF", REF: "REF", R: "REF", Z: "REF",
  BV: "VEL", V: "VEL", VEL: "VEL",
  SRV: "SRV", SRM: "SRV",
  CC: "CC", RHO: "CC", RHOHV: "CC",
  ZDR: "ZDR", DR: "ZDR",
  KDP: "KDP",
  SW: "SW",
  PHI: "PHI", PHIDP: "PHI", DP: "PHI",
  CFP: "CFP",
  ET: "EET", EET: "EET",
  // VIL has its own table -- it used to point at DTA (storm-total accumulation),
  // which coloured a kg/m2 field with an inches scale.
  VIL: "VIL",
  HC: "DHC", HHC: "DHC", HCA: "DHC",
  OHP: "DAA", DPA: "DAA", DAA: "DAA",
  STP: "DTA", DTA: "DTA",
};

/** Best guess at which built-in a file is meant to replace. */
export function guessTarget(palText: string): string | null {
  const { product, units } = parsePal(palText);
  if (product && PRODUCT_TO_PALETTE[product]) return PRODUCT_TO_PALETTE[product];
  if (units === "DBZ") return "REF";
  if (units === "KTS" || units === "KT") return "VEL";
  return null;
}

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

function slug(name: string): string {
  const base = name
    .replace(/\.pal$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || "palette";
}

interface PaletteState {
  custom: CustomPalette[];
  /** built-in palette id -> custom palette id currently replacing it */
  overrides: Record<string, string>;

  add: (name: string, pal: string) => { ok: boolean; error?: string; id?: string; target?: string | null };
  remove: (id: string) => void;
  /** Point a custom palette at a built-in (or "" to leave it unused). */
  setTarget: (id: string, target: string) => void;
  targetOf: (id: string) => string;
}

export const usePaletteStore = create<PaletteState>()(
  persist(
    (set, get) => ({
      custom: [],
      overrides: {},

      add: (name, pal) => {
        const check = validatePal(pal);
        if (!check.ok) return { ok: false, error: check.error };

        const { product, units } = parsePal(pal);
        const label = name.replace(/\.pal$/i, "").trim() || "Custom palette";
        const id = `user:${slug(name)}`;
        const entry: CustomPalette = { id, label, pal, product, units, addedAt: Date.now() };
        const existing = get().custom.some((p) => p.id === id);
        set({
          custom: existing
            ? get().custom.map((p) => (p.id === id ? entry : p))
            : [...get().custom, entry],
        });

        // The file usually says what it colours, so wire it up without asking.
        const target = guessTarget(pal);
        if (target) get().setTarget(id, target);
        return { ok: true, id, target };
      },

      remove: (id) => {
        const overrides = { ...get().overrides };
        for (const [k, v] of Object.entries(overrides)) if (v === id) delete overrides[k];
        set({ custom: get().custom.filter((p) => p.id !== id), overrides });
      },

      setTarget: (id, target) => {
        const overrides = { ...get().overrides };
        // one custom palette replaces at most one built-in, and vice versa
        for (const [k, v] of Object.entries(overrides)) if (v === id) delete overrides[k];
        if (target) overrides[target] = id;
        set({ overrides });
      },

      targetOf: (id) => Object.entries(get().overrides).find(([, v]) => v === id)?.[0] ?? "",
    }),
    { name: "weatherts.palettes" },
  ),
);
