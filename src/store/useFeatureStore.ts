import { create } from "zustand";
import { persist } from "zustand/middleware";

import { FEATURES, PRESETS, featureOfLayer, type PresetId } from "../lib/features";
import { getLayerModules } from "../layers/registry";
import { useAppStore } from "./useAppStore";

/**
 * Which features are switched off (ux-shell; lib/features.ts). Only the OFF
 * ones are stored, so a feature added later starts on for everyone, and an
 * install that never opened Settings > Features has nothing hidden.
 */
interface FeatureState {
  off: string[];
  setOn: (id: string, on: boolean) => void;
  applyPreset: (id: PresetId) => void;
}

const KNOWN = new Set(FEATURES.map((f) => f.id));

/** Layers of features that just went off are switched off with them. */
function dropLayers(ids: string[]): void {
  if (!ids.length) return;
  const gone = new Set(ids);
  const app = useAppStore.getState();
  for (const m of getLayerModules()) {
    const f = featureOfLayer(m.id, m.category);
    if (f && gone.has(f) && app.layers[m.id]?.visible) app.setLayerVisible(m.id, false);
  }
  // Split view off: back to one pane (paneOps imports half the app; loaded late).
  if (gone.has("multiPane") && app.paneCount > 1) {
    void import("../lib/paneOps").then((m) => m.setLayout(1, false)).catch(() => {});
  }
}

export const useFeatureStore = create<FeatureState>()(
  persist(
    (set, get) => ({
      off: [],
      setOn: (id, on) => {
        if (!KNOWN.has(id)) return;
        const off = get().off.filter((x) => x !== id);
        if (!on) off.push(id);
        set({ off });
        if (!on) dropLayers([id]);
      },
      applyPreset: (id) => {
        const p = PRESETS.find((x) => x.id === id);
        if (!p) return;
        const before = new Set(get().off);
        set({ off: [...p.off] });
        dropLayers(p.off.filter((x) => !before.has(x)));
      },
    }),
    {
      name: "weatherts-features",
      version: 1,
      partialize: (s) => ({ off: s.off }),
      merge: (persisted, current) => {
        const off = ((persisted as Partial<FeatureState> | undefined)?.off ?? []).filter((x) => KNOWN.has(x));
        return { ...current, off };
      },
    },
  ),
);

/** Whether a feature is on, outside React. */
export const featureOn = (id: string): boolean => !useFeatureStore.getState().off.includes(id);

/** Whether a feature is on, in a component. */
export function useFeature(id: string): boolean {
  return useFeatureStore((s) => !s.off.includes(id));
}

/** Whether a layer may be listed (its feature, if it has one, is on). */
export function layerAllowed(id: string, category: string | undefined, off: string[]): boolean {
  const f = featureOfLayer(id, category);
  return !f || !off.includes(f);
}

/** The preset the switches match now, or "custom". */
export function currentPreset(off: string[]): PresetId | "custom" {
  const have = [...off].sort().join(",");
  return PRESETS.find((p) => [...p.off].sort().join(",") === have)?.id ?? "custom";
}
